# a228dfb5 — a merge with an inert-diff-skipped gate must map to `"skipped"`, never `"pass"`

## Narrative

Card a228dfb5: EXCEPT when `outcome.value.skipped` is also set — a merge whose ENTIRE changed-path set was proven inert (card db9b0130) never spawned a gate at all, so this maps to `"skipped"` instead, never `"pass"`: the `pending_gate_ops.verdict` column this feeds is what `gate_status(opId)` reads back verbatim, and before this correction it collapsed a genuinely-skipped merge into the SAME `"pass"`/`passed:true` a real gate pass gets — disagreeing with `gate_history`'s own `gateOutcomeFromDetail` (db.ts), which already checks `detail.skipped` before `detail.passed` for the identical underlying fact. Checked BEFORE the plain `merged` mapping, mirroring that exact ordering. A REUSED self-check (`reusedOpId` set, `skipped` absent) is NOT this case — it's a real prior verdict and stays `"pass"`.

## Do not

- Do not map a `skipped:true` merge outcome to `"pass"` — before this correction it collapsed into the same `"pass"`/`passed:true` a real gate pass gets, disagreeing with `gate_history`'s own `gateOutcomeFromDetail`, which already checks `skipped` before `passed`.
- Do not confuse a `skipped:true` inert-diff merge with a REUSED self-check (`reusedOpId` set, `skipped` absent) — the reused case is a real prior verdict and correctly stays `"pass"`.
- Do not let `"skipped"` fall through to only the OUTER `outcome` field in `gateStatus`'s verdict-fields branch (§2 below) — it must join the same pass/fail branch so `passed` reads `false` for it, not just `outcome`.

## Second site — `gateStatus`'s pass/fail/skipped verdict-fields branch

### Narrative

`"skipped"` joins the SAME branch `"pass"`/`"fail"` build `rawVerdictFields` from (`sessions.gateStatus`), never its own separate branch — a skipped inert-diff merge carries the exact same payload shape a pass/fail does (settledAt/totalDurationMs/commitSubject/retriedFile:null/etc.); most of the gate-specific fields simply stay `undefined` since no gate ever spawned, the same "nothing to report" discipline every other field in that branch already follows. `passed` stays `t.record.verdict === "pass"` unchanged — this IS the fix: it now correctly reads `false` for `"skipped"` instead of never reaching this branch at all, which used to mean the OUTER `t.record.verdict != null ? { outcome: t.record.verdict } : {}` was the only thing surfacing anything, and `deriveMergeGateVerdict` never even wrote `"skipped"` before this card — the widening and that write land together, not independently.

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`'s `rawVerdictFields` ternary): lines 3754-3762, as of this tranche's HEAD (tranche 9).

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the merge-kind verdict-derivation closure): lines 726-769, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
