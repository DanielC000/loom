# 29fe2372 — `orphanRewriteOwnershipConfirmed` checked same IDENTITY, never same ENTITY

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 29fe2372 — `orphanRewriteOwnershipConfirmed` checked same IDENTITY, never same ENTITY

Traced by a Code Reviewer, NOT executed (card `29fe2372`) — a worker then built a hermetic repro and
confirmed it live. `6c04633d`'s own round-2 fix (`orphanRewriteOwnershipConfirmed`, this file's "Follow-up
6c04633d" section above) checks `directPathIdentity` equality only. `d4b25feb` round 2 established that
one identity can legitimately hold TWO independent records at once (one active-only, one pending-only,
disjoint tokens) — the ownership gate's own identity-only check cannot tell "this file is `updated`'s OWN
backing" apart from "this file is a DIFFERENT, independent record that merely shares `updated`'s
identity." The manager's ruling: the gate must check same ENTITY, not same identity.

### The repro

`X` raises twice while resolvable (`tA1`, `tA2`, active `A` at `Kx`) — a second token so a later clear can
be PARTIAL. `X` is deleted (unresolvable); a third raise (`tP`) — per `d4b25feb`'s own "the `existing`
lookup only runs when verified" fix, this never looks at `A` at all, and diverts to a wholly INDEPENDENT
pending record `P` (`sourceFile = pending-<sha256(directPathIdentity(X))>.json`). Two distinct entry
objects for one identity, confirmed directly via `listActiveMergeQuarantines()`.

`A`'s own durable file is then hand-edited to add `orphanLatchFiles: [P's own sourceFile]` — standing in
for the real production path (an "existing"-branch sibling-absorb whose own durable write fails,
`consumeMatchedPendingsIntoArmedEntry`'s own `else` branch, ~1321-1330): EMPIRICALLY CHECKED, reusing this
module's own `injectOpenSyncFailureForPrefix` seam — that real path instead CONSUMES `P` into ONE merged
entity (safe: `P`'s own token is already accounted for by the merge), never leaving two genuinely
independent records sharing one orphan reference. Reaching that exact shape through 100% production code
additionally requires the separately-carded, still-unguarded fresh-divert write (`divertRaiseEntry`
~1964-1966 / `enterMergeQuarantine` ~2206-2218, `writePendingDivertFile` with no occupant read) — SPLIT
OUT of this card's own scope by Lead ruling; see that follow-up card's own repro once filed.

A fresh-process reboot (re-reading both files from disk) reconstructs the SAME two-entry shape. A PARTIAL
clear of `A` (`tA2`; `tA1` remains outstanding) reaches `rewriteOrphanLatchFilesAfterPartialClear`, whose
pre-fix `orphanRewriteOwnershipConfirmed` wrongly confirmed ownership of `P`'s own file (same identity,
content identity also matched) and overwrote it with `A`'s own reduced content — destroying `tP`'s on-disk
record. `P`'s own in-memory record (in `pendingUnresolvedQuarantines`, untouched by `A`'s clear) kept
reporting `tP` as enforced regardless. A SECOND fresh-process reboot, with `tP` NEVER cleared by anyone,
showed `tP` completely gone — silently released, with no clear ever issued for it: FAIL-OPEN.

### The fix — two further layers, both required

1. **`anotherLiveEntryOwnsFile(filename, updated)`** — `true` iff some entry OBJECT other than `updated`
   itself (active or pending, ANY identity, including `updated`'s own) still physically depends on
   `filename` as its own current backing. A stronger, OBJECT-reference-aware restatement of
   `physicalOwnerRepoPaths`'s own two loops (fully subsumed: both of its match conditions are strict
   subsets of the ones here, each additionally gated on `!== updated`).
2. **`orphanFileTokensAccountedForByUpdate(orphanFile, updated, clearedToken)`** — `true` iff every REAL
   token physically present in `orphanFile`'s own on-disk content right now is already in
   `updated.tokens ∪ {clearedToken}` (the token this SAME partial clear just dropped). Mirrors
   `markedFinalFullyCoveredByClear`'s own content-containment pattern (`dd34da46`/`95ea8d3f`) rather than
   inventing a parallel one. A read failure or corrupt/unparseable JSON can never be proven safe.

`orphanRewriteOwnershipConfirmed` now requires ALL of: the pre-existing identity-only structural check,
layer (1), the pre-existing content-identity check, AND layer (2) — fail-closed if any one of them does
not hold. `clearedToken` is threaded through from both callers of `rewriteOrphanLatchFilesAfterPartialClear`
(`clearActiveEntryTokenAtKey`, `clearTokenFromPendingIndices`), which already have the token being cleared
in scope.

**Why content-based (layer 2) was chosen over a purely reference-based alternative, and why both are kept
together anyway:** the card's own alternative direction — refuse whenever any OTHER pending entry (by
object reference) names this `sourceFile`, regardless of identity — is layer (1) alone. This module's own
repeated lesson (`63e49ee2` round 5's "same identity is not same content"; `0dc514dc`'s own "CONTENT-based,
never reference-based" title) is that a reference/identity-only check alone has repeatedly proven
insufficient, so layer (2) is kept as an independent, content-based backstop — it also catches a stale
on-disk file with no live in-memory competitor at all (this module has hit that shape before, e.g.
`63e49ee2`'s own "evicted the in-memory record without ever creating a pending one" residual), which a
bare reference scan can never see.

### Tests

Three new scenarios in `merge-quarantine-raise-protect-failure.mjs`:
- **`29fe2372`** — the repro above, verbatim. Proven RED via `scripts/negative-control.mjs --ref
  d55a10418697ce3be952068c3306fddb8f708245` (the absolute pre-fix ref — `merge-quarantine.ts` there is
  byte-identical to main's own tip at that point; `HEAD` alone no longer reproduces anything once the fix
  itself is committed) and GREEN after — tree restored byte-identical.
- **`29fe2372-isolate-b`** — an isolating case for layer (2) alone: NOTHING in memory references the
  orphan file at all (it is written to disk only AFTER boot, never classified by PASS 1), so layer (1)
  would have passed on its own; only layer (2), reading a genuinely foreign token physically on disk,
  refuses. Ablation-verified directly (layer (1) temporarily short-circuited to never fire, rebuilt, this
  scenario's own discriminating check goes RED, layer (2) alone still catches it; restored).
- **`29fe2372-isolate-a`** — an isolating case for layer (1) alone: a GENUINE, LIVE, independent pending
  entry `P2`, reconstructed at boot from its own valid but token-LESS content, shares the orphan file as
  its own `sourceFile` — layer (2) finds zero real on-disk tokens and would VACUOUSLY pass on its own
  (nothing to object to); only layer (1), seeing `P2` as a genuinely separate surviving object, refuses.
  Ablation-verified directly (layer (2) temporarily short-circuited to always return `true`, rebuilt, this
  scenario's own discriminating check goes RED, layer (1) alone still catches it; restored).

All 33 `merge-quarantine*.mjs` files re-verified individually, each exit 0. All static guards
(`pnpm --filter @loom/daemon guards`) re-verified green (30/30).

### Do not

- Do not gate an orphan rewrite on IDENTITY alone, even layered with a content-identity check — same
  identity is not same ENTITY (`d4b25feb`'s own "two independent records, one identity, disjoint tokens"
  shape is exactly what an identity-only gate cannot distinguish). Require both an OBJECT-reference-aware
  ownership check (`anotherLiveEntryOwnsFile`) and a TOKEN-content-aware check
  (`orphanFileTokensAccountedForByUpdate`) — either alone has a reproduced, ablation-confirmed blind spot
  the other one covers.
- Do not reach for a purely reference-based fix here "because it's simpler" without also keeping a
  content-based layer — a reference check alone cannot see a stale on-disk file with no live in-memory
  competitor (the `29fe2372-isolate-b` shape); a content check alone cannot see a live, independent,
  token-less (or coincidentally-already-accounted-for) competitor (the `29fe2372-isolate-a` shape).
  **Scope of layer (2)'s own protection in the `isolate-b` shape** (Code Review `9d6dc6b8`): it protects
  ONLY against the REWRITE this card fixes. A later FULL clear still deletes that same file via
  `sweepOrphanLatchFileIfUnreferenced` (~:2660), which is content-blind — the CR reproduced the loss being
  DEFERRED, not prevented, for that exact shape. Not reachable from production today (a file physically
  present at boot becomes a live, PASS-1-classified owner, closing the gap this specific isolate-b
  fixture manufactures by writing the file only AFTER boot) — tracked as a known residual, carded
  separately; not fixed by this card.
- Do not conflate this card's own scope with the separately-carded fresh-divert write
  (`divertRaiseEntry`'s `indices.length === 0` branch, `enterMergeQuarantine`'s own direct
  unresolvable-brand-new-divert) — `writePendingDivertFile` there still has NO occupant read at all before
  overwriting a deterministic filename; this card's own fix does not touch it.
