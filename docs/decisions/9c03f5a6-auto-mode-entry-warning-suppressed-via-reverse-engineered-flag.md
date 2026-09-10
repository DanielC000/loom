# 9c03f5a6 — auto-mode entry-warning dialog suppressed via a reverse-engineered settings flag

## Narrative

`AUTO_MODE_ENTRY_WARNING_OVERRIDE` (`pty/claude-settings.ts`, `{ skipAutoPermissionPrompt: true }`) is a
BEST-EFFORT suppression of Claude Code's "auto mode" first-run entry-warning dialog — a SEPARATE
interactive gate from the `--dangerously-skip-permissions`/`bypassPermissions` acceptance dialog Loom
already avoids via a gate-free boot + allowlist. This key closes the residual risk that auto mode's OWN
one-time consent dialog could fire the first time a machine/profile ever reaches auto — exactly the kind
of unattended boot hang card 9c03f5a6 exists to eliminate. Now that the widened auto-heal (`host.ts`'s
`logLandedMode`) reliably drives every Loom-driven role all the way to auto, this residual risk is
reachable more often than it was when this key was first added.

That residual risk grew more reachable over time: card `51926260` changed WHEN a session reaches auto —
`computeBootMode` (`pty/host.ts`) now boots most Loom-driven roles (the platform/worker default)
DIRECTLY at `--permission-mode auto`, rather than booting gate-free at `acceptEdits` and
feedback-cycling to `auto` post-boot (see
`docs/decisions/016ee373-direct-boot-modes-typed-as-compile-time-guard.md` for that change's own
record). This key is written to the settings file BEFORE either kind of boot, so it's positioned to
matter either way — but whether the underlying CLI's entry-warning dialog is gated on a runtime
TRANSITION into auto (the case this key was originally reasoned about) versus firing identically for a
COLD boot already sitting in auto has not been separately re-verified against the new direct-boot shape;
that live-probe gap is tracked separately, not resolved here.

The suppression itself is UNVERIFIED / reverse-engineered: found by inspecting the installed CLI
binary's own gating logic (`skipAutoPermissionPrompt===true` on any of a few named settings scopes
suppresses the dialog). The exact settings-SCOPE Loom's per-session `--settings <file>` maps to was NOT
confirmed live — there was no real-CLI harness to probe it against in the environment this was written
in. It is purely ADDITIVE and safe even if the guess is wrong: an unrecognized settings key is simply
ignored by both an older CLI and (if the scope mapping turns out wrong) this CLI too — worst case is a
no-op, never a regression. It does NOT touch the spawn argv or whichever `--permission-mode` value a
session actually boots with (see `computeBootMode`) — settings-file key only.

## Do not

- Do not treat this key as a replacement for the proven gate-free boot recipe (direct-at-target or
  acceptEdits-then-cycle) — it is a belt on top of that recipe, not a substitute.
- Do not assume the settings-scope mapping is confirmed live — it was reverse-engineered from the
  installed CLI binary's gating logic with no real-CLI harness to verify it against.
- Do not assume the live-probe gap (runtime transition into auto vs. a cold boot already sitting in
  auto) has been closed just because `computeBootMode` now boots most roles directly at auto — it is
  tracked separately, not resolved by this key.

## Source

Inline comment in `packages/daemon/src/pty/claude-settings.ts` (`AUTO_MODE_ENTRY_WARNING_OVERRIDE`'s
own doc comment), commits `6b2a4c825` (2026-07-13, original) and `5df36f73b` (2026-08-26, card
`51926260` addendum on when a session reaches auto).
