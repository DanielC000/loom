# 615967c5 — a fresh-mint result is enriched with the CURRENT identity, closing the cached-verdict legibility gap

## Narrative

Card 615967c5: the verdict cache is keyed on the branch tip (`verdictIdentity`), and Loom's own
union-merge can advance that tip as a SIDE EFFECT of the very confirm call that produced the cached
verdict — so a re-call after a behind-main branch's own first confirm can legitimately mint a fresh gate
run, but every caller-visible outcome looked identical: `{opId, status:"pending"}`, with no way to tell
"a real new gate, because the base moved" apart from "you forced a re-run" or "here is your cached
verdict" (which it was not). On an active repo, behind-main is the COMMON case, so this invisibility hit
exactly the case a manager is most likely to re-call: after a confusing failure on a stale-based branch.
Left unaddressed, an accidental re-run is a free extra sample of a non-deterministic gate that can
eventually launder a red into a merge with no manager choosing to retry and nobody seeing the rejection
overruled.

FIX IS SELF-ANNOUNCING, NOT A CACHING CHANGE: the re-gating itself is semantically correct (the
union-merge changed what is under test, so the old verdict genuinely doesn't describe the new tree) — the
fix does not change the cache key, suppress the re-gate, or widen `identityOptional`; it only makes a
fresh mint say what identity it is now describing.

## `result.freshMint` gets `currentIdentity` folded in (site: `confirmWorkerMergeTracked`)

`result.freshMint` (set by the registry ONLY for a genuine fresh mint, never for a cache hit) already
carries the CACHED verdict's identity (`priorIdentity`) but not this call's own freshly-resolved one — the
registry is deliberately identity-vocabulary-agnostic (it never interprets `verdictIdentity`, only
compares it), so it has no notion of "current" beyond what the caller already resolved before `attach()`
ever ran. Folded in at the one place both are in scope — the caller, after `attach()` returns — rather
than widening the registry's own generic contract for this one caller. A cache hit (no `freshMint`) is
untouched: this only ever adds information to a result that already announces a fresh gate ran, never
changes whether one did.

## Do not

- Do not read `freshMint` with no `currentIdentity` as proof nothing changed — it only means this call's
  own currently-resolved identity was never folded in before this card.
- Do not widen the registry's own generic `verdictIdentity` contract to carry "current" identity — fold it
  in at the caller, the one place both the cached and current identity are already in scope.
- Do not touch a cache hit's shape — only a genuine fresh mint gets `currentIdentity`.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMergeTracked`'s
CURRENT-IDENTITY ENRICHMENT block (the `result.freshMint` fold-in after `attach()` returns), as of this
tranche's HEAD, plus board card `615967c5`'s own body (filed by the Platform Lead, 2026-08-04, from
Codescape escalation `b57b2686`, confirmed at source: `sessions/service.ts`'s `verdictIdentity` resolution
and `orchestration/pending-ops.ts`'s identity-gated miss).
