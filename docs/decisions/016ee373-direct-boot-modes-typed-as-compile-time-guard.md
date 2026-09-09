# 016ee373 / 51926260 — `DIRECT_BOOT_MODES` excludes non-CLI-accepted modes, typed as a compile-time guard

## Narrative

Card 51926260 — `DIRECT_BOOT_MODES` is the set of `LandedMode`s the real `claude --permission-mode` flag accepts DIRECTLY as a boot value (probe-verified: `claude --help` lists "acceptEdits"/"auto"/"plan" among its accepted `--permission-mode` choices). Deliberately excludes `bypassPermissions` (never reachable via `ACCEPT_EDITS_CYCLE_ORDER` anyway — see `cyclesToReachFromAcceptEdits`'s own doc — and kept off this list defensively, matching `HEALABLE_MODES`'s style) and `default`/`unknown` (not confirmed as accepted flag values — booting those still climbs off `acceptEdits` via the unchanged Shift+Tab convergence).

Card 016ee373 — typed `ReadonlySet<LandedMode & CliPermissionMode>` (not bare `ReadonlySet<LandedMode>`) so the initializer itself is a compile-time guard: a value that is a `LandedMode` but NOT a CLI-accepted `--permission-mode` value (e.g. `"default"`) — or vice versa — can no longer be added here without a `tsc` failure (proof: adding `"default"` to this initializer was shown to fail with TS2769 — see this card's `worker_report` for the pasted compiler output; not committed here as a permanent fixture since `tsc` itself IS the regression test for a type-level invariant).

## Do not

- Do not add `default`/`unknown`/`bypassPermissions` to `DIRECT_BOOT_MODES` — none are confirmed-accepted direct `--permission-mode` boot values, and the type `LandedMode & CliPermissionMode` will reject an invalid addition at compile time (this is deliberate, not incidental).
- Do not loosen `DIRECT_BOOT_MODES`'s declared type back to bare `ReadonlySet<LandedMode>` — that would remove the compile-time guard; bridge a plain `LandedMode` value via `isDirectBootMode`'s type predicate instead.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`DIRECT_BOOT_MODES`'s top-of-const doc), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
