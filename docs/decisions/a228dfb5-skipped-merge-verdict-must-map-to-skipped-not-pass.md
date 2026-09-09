# a228dfb5 — a merge with an inert-diff-skipped gate must map to `"skipped"`, never `"pass"`

## Narrative

Card a228dfb5: EXCEPT when `outcome.value.skipped` is also set — a merge whose ENTIRE changed-path set was proven inert (card db9b0130) never spawned a gate at all, so this maps to `"skipped"` instead, never `"pass"`: the `pending_gate_ops.verdict` column this feeds is what `gate_status(opId)` reads back verbatim, and before this correction it collapsed a genuinely-skipped merge into the SAME `"pass"`/`passed:true` a real gate pass gets — disagreeing with `gate_history`'s own `gateOutcomeFromDetail` (db.ts), which already checks `detail.skipped` before `detail.passed` for the identical underlying fact. Checked BEFORE the plain `merged` mapping, mirroring that exact ordering. A REUSED self-check (`reusedOpId` set, `skipped` absent) is NOT this case — it's a real prior verdict and stays `"pass"`.

## Do not

- Do not map a `skipped:true` merge outcome to `"pass"` — before this correction it collapsed into the same `"pass"`/`passed:true` a real gate pass gets, disagreeing with `gate_history`'s own `gateOutcomeFromDetail`, which already checks `skipped` before `passed`.
- Do not confuse a `skipped:true` inert-diff merge with a REUSED self-check (`reusedOpId` set, `skipped` absent) — the reused case is a real prior verdict and correctly stays `"pass"`.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the merge-kind verdict-derivation closure): lines 726-769, as of commit `f9caa77e30d5c1a6dd994b6203261968c0dbf94f`. Relocated by card `8f4c8a8f`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
