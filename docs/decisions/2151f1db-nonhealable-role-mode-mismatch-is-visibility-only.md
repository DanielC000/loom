# 2151f1db — a non-healable role's landed-mode mismatch gets visibility, not auto-correction

## Narrative

`logLandedMode`'s auto-heal only fires for a role `disallowedToolsForRole` disallows `ExitPlanMode` for (worker, setup, auditor, workspace-auditor, run, assistant) — a manager, platform, or plain session is deliberately excluded from that backstop, because it may legitimately choose `plan` for itself and can exit it unassisted. But the boot mode-cycle's own footer-read confirmation can still fail under host contention for one of these roles exactly as it can for a healable one (`cycleToMode`'s give-up branch can leave ANY role short of its target) — and unlike a deliberate choice, that failure is currently silent: the session only discovers it later, indistinguishable from having chosen the mode itself. So instead of auto-correcting, a mismatch for one of these roles gets a visibility-only `[loom:mode-unconfirmed]` nudge telling the session its landed mode may not have been a deliberate choice, rather than a driven `cycleToMode` call.

The mismatch test for this branch is `mode !== healTarget`, not mere `HEALABLE_MODES` membership — this matters because, unlike a worker/setup/auditor role (whose target is always pinned to `"auto"` regardless of project config), a manager/platform/plain role's configured target could in principle itself be a `HEALABLE_MODES` member (e.g. a project deliberately configured to land one there). Testing membership alone would false-positive that deliberate configuration as a mismatch; testing against the role's own resolved `healTarget` does not.

## Do not

- Do not auto-correct a manager/platform/plain session's landed permission mode via `cycleToMode` — only notify it (visibility only), since the role may have deliberately chosen that mode and can self-exit it.
- Do not test this mismatch by `HEALABLE_MODES` membership alone — test `mode !== healTarget` against the role's own resolved target, or a deliberately-configured landing in a `HEALABLE_MODES` mode false-positives.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`logLandedMode`'s function body), as of main `cba3068d`. Condensed and reworded, not verbatim. The excluded-role list (worker, setup, auditor, workspace-auditor, run, assistant) is derived from `disallowedToolsForRole`'s own case block (`packages/daemon/src/pty/host.ts` ~line 3057), not from the removed comment, which named none of them explicitly. The `[loom:mode-unconfirmed]` tag is read from the code at the `enqueueStdin` call just below this comment's site, not from the comment itself.
