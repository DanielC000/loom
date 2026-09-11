# 65336570 — the reduced-gate NOT_HERMETIC declaration must reach the nudge, not just the sync return

## Narrative

Card 65336570: card `17cd1f30` shipped a `reducedGateWarning` declaration naming which NOT_HERMETIC
file(s) a reduced gate excluded, but only onto the sync `warning` field — a surface the intended reader
never reaches, because a real gate ALWAYS returns `{status:"pending", opId}` (13m+ runs), so the sync
return's `warning` is never delivered on the normal path. VERIFIED on a real merge op (`2984278f`,
batch 3): the reduced path ran, `emitCompareWarning` WAS constructed with the NOT_HERMETIC clause, but the
`[loom:merge-done]` nudge actually received carried the steps line + concurrency triple and no
NOT_HERMETIC clause — the green nudge template did not (and structurally could not, via the sync-only
field) include it.

THE POSITIVE CONTROL THAT MADE THIS A REAL ABSENCE: `skillNote` (card 64a30c79,
[[64a30c79-merge-does-not-mean-live-for-a-skill-asset-change]]) sits in the SAME nudge template and IS
delivered — proving the template can carry a warning; the reduced-gate declaration specifically was never
wired to it. The fix mirrors `skillWarning`/`skillNote` exactly rather than inventing a new mechanism: a
distinct field (never folded into the generic `warning` join, so it can't be crowded out) with its own
nudge echo.

## Echoed on the async `[loom:merge-done]` nudge too (site: `confirmWorkerMergeTracked`)

`reducedGateWarning` is echoed on the async settle nudge as `reducedGateNote`, mirroring `skillNote`
immediately beside it EXACTLY. Without this, a manager who only reads the async nudge — the ONLY path a
real gate ever actually takes — never learns the gate was reduced at all, let alone which NOT_HERMETIC
file(s) it excluded, even though the sync `warning` field carried it the whole time on the rare
fast/reused/gateless settle. Absent (empty string) for every merge that didn't run the reduced-gate
substitution, byte-identical to before this card.

## Do not

- Do not treat the sync `warning` field as a real delivery surface for this declaration — a real gate
  never settles synchronously, so that field is structurally undelivered on the normal path.
- Do not fold the reduced-gate declaration into the generic `warning` join — a dedicated field, mirroring
  `skillWarning`, keeps it from being crowded out.
- Do not name only a bare count of excluded files — name the excluded file(s) themselves.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMergeTracked`'s async settle
callback (`reducedGateNote`), as of this tranche's HEAD, plus board card `65336570`'s own body (filed by
the Loom lead, 2026-08-25, from checking whether card `17cd1f30`'s own DoD-2 actually surfaced).
