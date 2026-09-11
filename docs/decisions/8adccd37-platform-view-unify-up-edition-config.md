# 8adccd37 — Platform surface stays ONE shell with real config-selected forks, never a fork-collapse

## Narrative

`DeveloperPlatformView.tsx` and `EndUserPlatformView.tsx` were near-duplicate scaffold (~46% shared, ~6% pure dup) that had begun to drift, but the remaining ~48% was genuinely divergent BEHAVIOR, not incidental copy-paste: multi-Lead vs singleton operator gating, a list-vs-single-form auditor-schedule data model, distinct endpoints/roles, and a grid-vs-split layout. The owner's "unify up" umbrella decision (question `41210cfd`, Option A) resolved this card's own A-vs-B choice: because Bucket 2b (the operator's elevated surface) is NOT shipping to end users, those four forks stay REAL rather than being homogenized away — so the fix is ONE shared `PlatformView` shell (`platformEdition.ts` + `PlatformView.tsx`) driven by a data-only `edition` config, with the dev surface as the canonical rendering and the forks kept as explicit, config-selected leaves. Research: vault `Design/[[Platform Divergence — Unify Up + Thin Local Overlay]]`.

## Do not

- Do not force the four behavioral forks (multi-Lead/singleton, auditor-schedule list/single-form, endpoints/roles, grid/split layout) into one homogenized code path — they are deliberate, not drift, for as long as Bucket-2b stays unshipped.
- Do not let the edition-preview `ViewAsToggle` (Platform.tsx) become anything but a pure client-side view switch — it must never be read by, passed to, or wired into a spawn/role/stop REST call, in either `platformEdition.ts` or `PlatformView.tsx`.

## Source

Inline comment in `packages/web/src/pages/platformEdition.ts` (the module's top-of-file doc, lines 5-9) and `packages/web/src/pages/PlatformView.tsx` (the module's top-of-file doc, lines 21-24), as of card `7071275f`'s tranche HEAD. Card `8adccd37` (`refactor(web): unify Developer/EndUser PlatformView behind a shared shell`, merged commit `9642305ba37791147ec677248bf344eb54ef545a`). Extracted by card `7071275f`; wording condensed from both sites, no substantive detail dropped.
