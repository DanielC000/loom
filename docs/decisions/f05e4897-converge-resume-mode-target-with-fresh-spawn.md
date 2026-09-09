# f05e4897 — resume mode-cycle convergence: target derivation, and why `ACCEPT_EDITS_CYCLE_ORDER` is safe despite being incomplete

## Converge `--resume`'s boot mode with what a fresh spawn of the same config would reach

RESUME mode convergence (card f05e4897, generalized to fresh spawns too by `b99d3d67`) — SUPERSEDES an earlier blind `startupModeCycles:0`. `resumeModeTarget` is what lets a `--resume` reach the SAME target a fresh spawn of this config reaches, since `--resume` HONOURS `--permission-mode` and does NOT restore the persisted mode (probe-verified on 2.1.163) — the raw `permission.mode` field stays `acceptEdits` (a `resolveAgentSpawn`/`PermissionPolicy` constant), but card `51926260`'s `computeBootMode` (`pty/host.ts`, at the actual spawn chokepoint) resolves `resumeModeTarget` into the REAL `--permission-mode` flag directly when it's expressible, so a resume typically boots straight at its target with zero presses. `computeBootMode` falls back to the SAME feedback-verified cycler (`cycleToMode`) for a target that isn't directly expressible, instead of a fixed blind press count (an earlier blind-2 count half-landed on `plan` on the summary-gate path — the 2026-06-03 strand bug; a blind-0 left it ONE short, stuck at `acceptEdits`). Resume passes its target EXPLICITLY via `resumeModeTarget` — wherever a FRESH spawn of THIS config lands (`modeAfterCyclesFromAcceptEdits` of the same `startupModeCycles` → `auto` by default) — so a resumed session matches a fresh one exactly. `startupModeCycles` itself is moot on this path (host.ts prefers `resumeModeTarget` when set via `??`), so it's pinned to `0` defensively. Read off `resumePermission` (`resolveAgentSpawn`'s ROLE-AWARE result when the agent exists, else `withRolePermissionModeCyclesPin`'s own role-only re-derivation), not the bare `config.permission` — a worker's/assistant's `startupModeCycles` is pinned to `auto` independent of the project's own knob, and this must match regardless of whether the agent row backing it still exists (card `e98877b1`).

**Do not:**
- Do not give `--resume` a blind/fixed Shift-Tab press count (or a blind `startupModeCycles:0` with no explicit target) — pass `resumeModeTarget` explicitly, computed as wherever a FRESH spawn of this config would land.
- Do not assume `--resume` restores the persisted permission mode on its own — probe-verified (2.1.163) that it honours `--permission-mode` instead.

## `ACCEPT_EDITS_CYCLE_ORDER` is probe-mapped, and safe even where it's incomplete

The cycle order Shift+Tab walks from the gate-free `acceptEdits` boot mode, AS OBSERVED under Loom's own spawn conditions (claude 2.1.163; mapped by the probe — `test/_probe-resume-mode.mjs`): `acceptEdits →(+1) plan →(+2) auto →(+3) default →(+4) acceptEdits` (period 4).

Card `8c60c068` — re-verified against the installed CLI (v2.1.246) by extracting its bundled JS: the real mode-cycle handler is a CONDITIONAL state machine, not a fixed array. From `plan` it advances to `bypassPermissions` if that mode is available, else `auto` if THAT is available, else `default`; `bypassPermissions` is available ONLY when the session was launched with `--dangerously-skip-permissions` (Loom never passes that flag, so that branch is permanently dead here — correctly omitted). `auto`'s availability is genuinely dynamic at runtime, so this array/period-4 arithmetic describes the cycle correctly only when `auto` is available (the expected case), not as a universal guarantee of the real CLI's behavior.

This is safe in practice, not just lucky: `runCycleToMode`'s press loop never blind-presses off this array — it presses ONE Shift+Tab, observes the REAL footer mode, and only stops (`nextCycleAction`) on what it actually reads, or gives up leaving the session at its last observed mode. This array is only ever used to LABEL a target mode from a `startupModeCycles` integer (`modeAfterCyclesFromAcceptEdits`); it is never used to blindly count presses against the real terminal.

**Do not:**
- Do not treat `ACCEPT_EDITS_CYCLE_ORDER` as a universal guarantee of the real CLI's cycle behavior — it's correct only when `auto` is available; the array is a LABEL for a target mode, never a blind press-count source.
- Do not add `bypassPermissions` to this array — permanently unreachable since Loom never passes `--dangerously-skip-permissions`.

## Source

- Originally an inline comment in `packages/daemon/src/sessions/service.ts` (`resume()`, on the `pty.spawn` call), lines 3933-3955 as of commit `9818aa2627c6f58c26aaaec6fc33d70c468c3943`. Relocated by card `3c50eae9`. See also `docs/decisions/e98877b1-preserve-role-mode-pin-when-agent-row-missing.md` and `docs/decisions/760cd01d-pin-worker-boot-mode-to-auto.md` / `docs/decisions/5603f40f-pin-assistant-boot-mode-to-auto.md`.
- `packages/daemon/src/pty/host.ts` (`ACCEPT_EDITS_CYCLE_ORDER`'s top-of-const doc), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`). Folded into this pre-existing `f05e4897` record (rather than a second file) after tranche 2 created a same-id collision the injector's one-record-per-id resolution can't serve.
