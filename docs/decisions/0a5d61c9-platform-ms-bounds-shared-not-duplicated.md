# 0a5d61c9 — export the DAEMON-GLOBAL platform MS bounds table so the Settings UI can translate units

## Narrative

`PLATFORM_MS_BOUNDS` is the one-layer-up twin of `ORCHESTRATION_TIMEOUT_MS_BOUNDS` (card `48365fda`), and it exists for the same reason: the Global / Daemon grid in `packages/web/src/pages/Settings.tsx` is labelled and entered in `s`/`m`/`h` but stores canonical milliseconds, while every bound lived only inside `packages/daemon/src/mcp/platform.ts`'s zod schema. So an out-of-range entry round-tripped to a 400 quoting a raw millisecond figure into a field measured in seconds or hours — "expected number to be <=3600000" under a label reading "Git push (s)". `48365fda` fixed exactly three fields (the per-project gate/deploy/webhook timeouts) and left the ~20-field daemon-global grid with no bounds at all.

The literals were MOVED, not copied: `platformConfigOverrideSchema` now builds every ms-keyed `.min()/.max()` by reading this table, so there is still exactly one place a daemon-global ms range is written down. `packages/daemon/test/platform-ms-bounds.mjs` pins each entry against the value the schema enforced before the move, so a relocation can never silently retune a bound.

The table is deliberately keyed by config GROUP then field (mirroring `PlatformConfigOverride`'s own shape) and deliberately covers ONLY the ms-keyed fields. A plain-count field — `rateLimit.exhaustedThresholdPct`, `backup.keep`, `maxConcurrentGates`, `usageSampleRetentionDays` — has no unit to translate between, so its raw validator message already reads in the unit the field is entered in; adding it here would imply a translation that doesn't exist.

The second half of the same card is the conversion itself. `Number(s) * UNIT_MS[unit]` is not safe to send to an `.int()` validator: `16.1 * 1000` is `16100.000000000002` in IEEE-754 binary floating point, so a perfectly reasonable "16.1" in a seconds field came back as a 400 "Expected integer". Every user-string → canonical-ms conversion in `Settings.tsx` therefore routes through ONE helper, `msFromUnit`, which rounds. Rounding at the helper also keeps the client-side range check honest: `msRangeError` compares the SAME integer that `buildGlobalOverride`/`applyMs` will actually send, so the inline error can never disagree with the server about whether a value is in range.

## Do not

- Do not duplicate a daemon-global ms bound as a second literal in `packages/web` — read `PLATFORM_MS_BOUNDS` from `shared`. This includes prose: a hint reading "1–60 minutes" is the same duplicate in a different font, and it drifts the same way.
- Do not write a bound literal back into `platformConfigOverrideSchema`'s `.min()/.max()` — it reads the shared table on purpose; a literal there is a second source of truth.
- Do not add a plain-count (unitless) field to this table. It has no unit to translate, and listing it implies one.
- Do not convert a user-entered value to canonical ms with a bare `Number(s) * UNIT_MS[unit]` anywhere in `packages/web` — use `msFromUnit`. An unrounded product is a float, and every server-side ms validator is `.int()`.
- Do not range-check an unrounded value while sending a rounded one (or vice versa) — both sides must compare the same integer, or the inline error and the server's verdict can disagree at a boundary.

## Source

Written with card `0a5d61c9`. The `48365fda` record is the per-project predecessor; read it first.
