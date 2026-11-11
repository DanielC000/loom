# 462c4ae8 — turn off Claude Code's auto-mode-setup consent offer in every per-session settings file

Split from card 20ff76de: this lands only the suppression; the mid-session hold stays on that card's own lane.

## The modal

After enough auto-mode use (numStartups >= 5 and repeated auto-mode denials) Claude Code shows a consent modal, "Teach auto mode about your environment?". Enter on the default answer is Yes, which runs `/auto-mode-setup`: it scans the project and sessions and then writes `~/.claude/settings.json`. In a Loom-driven session nobody answers it, so it blocks the turn and, if Enter lands on it, mutates the user's real settings.

## The change

`writeSessionSettings` (`pty/claude-settings.ts`) adds `skillOverrides: {"auto-mode-setup": "off"}` (`AUTO_MODE_SETUP_OFFER_OVERRIDE`) to every per-session `--settings` file, spread next to `skipAutoPermissionPrompt`. The key is the documented off switch:

- https://code.claude.com/docs/en/auto-mode-config.md, section "Turn off /auto-mode-setup"
- https://github.com/anthropics/claude-code/issues/100974

Test: `packages/daemon/test/settings-auto-mode-setup-off.mjs` (mechanical wiring only).

## Residual (unverified)

The docs scope the key to `~/.claude/settings.json`. Whether it takes effect when delivered through `--settings` is UNVERIFIED; no bounded probe exists because the offer needs the usage thresholds above. If it proves not to honor it, the owner's manual fallback is "Don't show again" on the modal.

## Do not

- Never write the user's own `~/.claude/settings.json` or `~/.claude.json` (including its undocumented `autoModeEnvSetup`) to suppress this; the per-session file is the only place.
- Never touch `disableAutoMode` or `disableBundledSkills`; they switch off far more than this one offer.
- Do not add a suppression key to `claude-config.ts` `ensureTrusted`; it carries only a comment pointing here.
