# 2961dd3b — `SESSION_ROW_FIELDS`'s sentinel forces every `Session` key, required AND optional, not just required ones

## Narrative

Card 2961dd3b: the field-by-field object literal `worker_status`'s projection helper used to return was BEHAVIOUR-PRESERVING against today's row shape, but its claimed compile-time guarantee — "the next addition to `Session` is a deliberate one-line choice here, not an automatic one" — held only for `Session`'s REQUIRED fields. TypeScript does not force an object literal to name an OPTIONAL property, and `Session` has TWENTY-EIGHT of them (`role?`, `parentSessionId?`, `taskId?`, …), so a new `newThing?: X` on `Session` would have compiled fine here while silently dropping from every consumer (`worker_status`, `worker_list`, …) with no build error and no test failure. `SESSION_ROW_FIELDS` closes that gap the same way `entityRowFields.ts`'s `PROJECT_FIELDS`/`AGENT_FIELDS`/`PROFILE_FIELDS` do: `Record<keyof T, 1>` forces EVERY key, required and optional alike, so a field added to `Session` in `@loom/shared` now breaks the build at this sentinel until it's a deliberate, reviewed addition.

⚠️ THE SENTINEL VALUE IS THE NUMBER `1`, NOT THE BOOLEAN LITERAL — this file compiles into `dist/mcp/*.js`, the same directory `test/agent-runs-keys.mjs` (G3) textually scans for a literal `endpoint:\s*true` (see `entityRowFields.ts`'s own doc comment for the full mechanism). `Session` carries no `endpoint` field today, but the numeric marker costs nothing and keeps this file immune to the same class of collision regardless.

## Do not

- Do not write `SESSION_ROW_FIELDS`'s sentinel values as `true` — use the numeric `1`, so this file's compiled output can never collide with `test/agent-runs-keys.mjs`'s textual scan for a literal `endpoint: true`.
- Do not assume a field-by-field object literal alone (without a `Record<keyof Session, 1>` sentinel) catches every future `Session` addition — TypeScript does not force an object literal to name an OPTIONAL property, so an optional field can silently drop from every consumer with no build error.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above `SESSION_ROW_FIELDS`): lines 2787-2801 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
