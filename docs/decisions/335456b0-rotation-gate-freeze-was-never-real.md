# 335456b0 — the "FROZEN … never edit it" line in rotation-check.ts's header was never true

## Narrative

`rotation-check.ts:12-13` declared, verbatim, since it was written: *"that script is FROZEN for this card: migrate off it, never edit it."* Card `6dd3a17c` (merged `f01668c4`) edited `rotation-gate.mjs` anyway, reviewed and approved by the lead — and in being corrected on the citation, the lead read line 12 for the first time. Filed as `335456b0` to reconcile the contradiction: research, not build.

## What card 1069c8e1 actually said, at source

The card that authored `rotation-check.ts` (`1069c8e1`, merged `d345bcd6`, 2026-09-02) never says "never edit" anywhere in its body. Its actual instruction: *"Do NOT delete `rotation-gate.mjs` as part of this. It is live, it works, and it is currently the ONLY thing preventing the Loom manager from silently dropping doctrine mid-cut. Migrate, then retire — never the reverse."* Its DoD-5 says *"Migrate the three seats onto it, or explicitly record why one stays hand-rolled."* Both are far softer than the header's absolute prohibition — a ban on **deleting** it before a migration completes, not a ban on **editing** it at all. The header overstated the card that supposedly authorized it.

## What actually happened, measured

`git log --follow` on `packages/daemon/scripts/rotation-gate.mjs`, filtered to commits after `d345bcd6` (2026-09-02T07:04:13+02:00, the freeze's own creation instant): **8 separate commits edited it**, every one reviewed and merged, spanning 2026-09-02 through 2026-09-15 — `12bb5640`, `2e85fef9`, `9ac11bef`, `2085c511`, `0ffb1755`, `09964c48`, `00826f1c`, `f01668c4`. Diffstats range from 12 to 257 changed lines; none are no-ops. This is not one lapse — it is the file's entire post-freeze history. The freeze, as literally written, was never observed even once.

## The two implementations have NOT converged — migration has not happened

Only 2 of those 8 commits (`9ac11bef`, `f01668c4`) touched `rotation-check.ts` in the same change. The other 6 changed `rotation-gate.mjs` alone. One of them, `2e85fef9` ("audit rotation-gate's marker and floor copy against the vault"), added a whole new capability — `--audit-vault`, a drift detector comparing the script's own `MARKERS`/`LIVE_COMMITMENTS_FLOOR` against the live vault — that has **no counterpart in `rotation-check.ts`/`resume_doc_check`** (verified: `grep -n "audit-vault\|auditVault"` against `rotation-check.ts` returns nothing). `rotation-gate.mjs` also still owns `--was` (cut-scoped byte-shrink assertion) as a CLI ritual; `runResumeDocCheck` only exposes the equivalent via a `preEditBytes` argument a caller must supply, not a first-class flag. The script is not atrophying toward retirement; it is still gaining scope the module doesn't have.

## The doctrine documents this as permanent, not transitional

`Operations/Orchestrator Rules.md` §ROTATION-GATE (read at source, 2026-09-15) never mentions migrating off or retiring `rotation-gate.mjs` — "retire" there means retiring individual **markers** from the list, a different sense entirely. It instead instructs, unconditionally: *"RE-RUN BOTH CHECKERS AFTER EVERY WRITE TO THE ACTIVE DOC, not only at a rotation — `rotation-gate.mjs --lint` AND the `resume_doc_check` MCP tool. They read TWO INDEPENDENT marker lists with no shared source ... so agreement is worth something and a divergence is a real signal."* It also records a live incident where running both, not one, is what kept a lead from acting on two false-green readings undetected by the other checker (§RUN-THE-GATE-SO-IT-ACTUALLY-RUNS, `gen 269`, 2026-09-05). The doctrine and the freeze's stated goal ("migrate off it") have been pulling in opposite directions since the freeze was written, and only the header's text ever noticed.

## Resolution

The header is corrected in the same commit as this record to state the architecture as it has actually operated for two weeks: `rotation-check.ts` is a deliberately independent second implementation, kept separate on purpose (the independence itself has caught real divergences — `9ac11bef` is the fix for one). `rotation-gate.mjs` is not frozen and carries no retirement plan; it is the Loom Orchestrator's live, actively-maintained rotation gate, still ahead of `rotation-check.ts` in capability (`--audit-vault`), and normal maintenance edits to it are expected, not violations. No vault change is needed — `Operations/Orchestrator Rules.md` already reflects this reality; only `rotation-check.ts`'s header was out of step with it.

## Do not

- Do not read the old header language ("FROZEN … never edit it") as ever having been sanctioned by card `1069c8e1` — it overstated that card's actual, narrower instruction (don't delete; migrate-then-retire is a future condition, not a current mandate).
- Do not treat "deliberately not shared code" as evidence of an in-progress migration — it is the intended, permanent architecture: two independent instruments whose disagreement is itself a signal, per `Operations/Orchestrator Rules.md` §ROTATION-GATE.
- Do not attempt to retire or delete `rotation-gate.mjs` on the theory that `rotation-check.ts` already supersedes it — it does not: `--audit-vault` has no port, and no card currently proposes retiring the script.
- Do not treat a future edit to `rotation-gate.mjs` as a freeze violation needing escalation — editing it is normal, expected maintenance, evidenced by 8 merged commits in the two weeks after the freeze was declared.
