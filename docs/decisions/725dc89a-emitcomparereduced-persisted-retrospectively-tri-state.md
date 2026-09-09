# 725dc89a — persist the reduced-gate facts on the settled op too, tri-state, not just in the live nudge

## Narrative

Card 725dc89a is the RETROSPECTIVE half of card `65336570` (which echoed the same declaration into the `[loom:merge-done]` nudge TEXT only). The durable `build_gate` audit event has always persisted `emitCompareReduced`/`emitCompareIdenticalCount`/`emitCompareTestFiles`/`emitCompareNotHermeticExcluded` unconditionally (card `17cd1f30`), but nothing read it back on a settled op — a manager investigating a past merge after the nudge scrolled away had to go read raw audit events. This closes that: the structured facts (not the nudge's rendered sentence) land on `pending_gate_ops.verdict_payload_json` too.

`emitCompareReduced` is TRI-STATE on purpose (card 725dc89a DoD-3 — the same `composerDirtyLen` null-vs-0 discipline, one field over): `true` means this merge's gate genuinely ran reduced (card `2154b6ad`); `false` means a REAL gate spawned for this op and was PROVEN NOT reduced (the positive control — a non-reduced merge must read as genuinely non-reduced, never as missing data); `undefined` means EITHER no gate spawned for this op (gateless project, a REUSED self-check, a pre-gate rejection) OR this row predates card 725dc89a entirely. Populated on the same two dominant return paths (`gateCap`/`outputTail`'s scope) — `undefined`, not fabricated `false`, on the rarer post-gate-PASS rejections those two fields also leave unwired.

`emitCompareIdenticalCount`/`emitCompareTestFiles`/`emitCompareNotHermeticExcluded` are set ONLY alongside `emitCompareReduced:true` — mirroring the `build_gate` event's own `emitCompareSkip ? {...} : {}` gating exactly — and are `undefined` (never `[]`/`0`) whenever `emitCompareReduced` isn't `true`, so an empty array can never be misread as "reduced, but nothing was excluded" vs "not reduced at all". `emitCompareNotHermeticExcluded` (card `17cd1f30`) names the specific changed test file(s) excluded from `--only=` (same NOT_HERMETIC exclusion the full suite also never gates) — the file names, not just a count.

## Do not

- Do not treat `emitCompareReduced: undefined` as "not reduced" — it means unrecoverable/not-applicable, and a REAL non-reduced run is stamped `false` instead, never left absent.
- Do not read an empty `emitCompareTestFiles`/`emitCompareNotHermeticExcluded` array as "reduced but nothing excluded" when `emitCompareReduced` isn't `true` — those fields are `undefined`, not `[]`, in that case.
- Do not conflate this field with `emitCompareNotApplicableKind` (card `fd0d34da`) — that field is set IFF this one is left `undefined` because the predicate's own verdict was `notApplicable:true`, never alongside a real `true`/`false`.

## Source

Inline comment in `packages/daemon/src/db.ts` (`PendingGateOpVerdict.emitCompareReduced` and siblings): lines 2176-2201, as of this tranche's HEAD.
