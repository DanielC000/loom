# 424ed9a8 — CONCURRENCY NEIGHBOURHOOD: attributing a gate run to the concurrency it actually ran under

## Narrative

Card 424ed9a8 was filed because a peer project's one confirmed CLASS 3 gate failure (process death, no failing test) was permanently unattributable — op `f954fb86` failed on a tree op `8c7f078e` had just passed minutes earlier, and nothing recorded what cap or how many concurrent gates were in force during either run; unanswerable in hindsight no matter how hard anyone re-reads the surviving output. `concurrentAtStart` (rendered `concurrentGates=`) is the fix: the semaphore's own active-run count AT THE INSTANT this run was admitted (read inside the `fn` callback, so it reflects admission, not settle — a released slot could already read low again by settle time), carried onto every audit event. Cheap to carry, and the only way the NEXT such pair is attributable instead of another permanent mystery — never prune it as noise; it looks unused right up until the one investigation that needs it, with no way to backfill retroactively.

`concurrentGates` answers exactly one question — how many gates were admitted together AT THE INSTANT this one started — and answers it perfectly; it does NOT answer how many ran AT ANY POINT during the run (a gate admitted solo and joined 30s later by a second project's gate reads as uncontended here even though it spent ~95% of its runtime alongside another run — the exact misreading card `c6750500` was filed to fix, see [[c6750500-getmaxconcurrentgates-closes-over-entry-not-a-registry-lookup]]). `concurrentGates` keeps this EXACT meaning and value going forward, unchanged and unrenamed, because a 600+-row historical corpus depends on it — a rename or reinterpretation would break every existing comparison. `concurrentGatesMax` is the true max-over-run companion, populated only on runs from card `c6750500` forward and left empty for historical rows — any analysis spanning older and newer rows must handle both fields independently, never assume one implies the other.

The rendered label itself was later renamed (Code Review, card `e2b6f900`): `concurrentGates=` replaces the earlier bare `concurrentAtStart` echo, unifying the name across `ConfirmMergeResult`/`PendingGateOpVerdict`/`gate_history`'s column/`gate_status`'s field so it is greppable across the nudge text and every structured surface — checked first that no test asserted the old label's exact text before renaming.

## Do not

- Do not prune `concurrentGates`/`concurrentGatesMax` as unused — they exist solely so the next unattributable byte-identical pass/fail pair is attributable, and there is no way to backfill them after the fact.
- Do not rename or reinterpret `concurrentGates`' meaning — a 600+-row historical baseline depends on its exact, unchanged semantics.
- Do not read `concurrentGates` as "how many ran at any point during this run" — that is what `concurrentGatesMax` answers; conflating the two is the exact mistake card `c6750500` was filed to fix.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`'s "CONCURRENCY NEIGHBOURHOOD" doc block (line ~12412) and its `gate_history`-detail rename note (line ~13328), as of this tranche's HEAD before extraction. Condensed, not verbatim: wrapped source lines joined into flowing paragraphs, `//` markers stripped, no wording changed beyond joining.
