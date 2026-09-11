# b99d3d67 — the fresh-spawn permission-mode cycle was generalized off resume's own footer-driven convergence primitive

## Narrative

`cycleToMode` (`packages/daemon/src/pty/host.ts`) started as a RESUME-only mechanism (card `f05e4897`) and was generalized by card `b99d3d67` into one primitive used by BOTH a fresh spawn and a `--resume`, driving the footer to an ABSOLUTE target mode. The two paths were unified because they shared the same starting point and needed the same fix: both historically booted at the gate-free `acceptEdits` mode and needed to climb the identical distance from there to their real target.

Before this generalization, the FRESH-spawn path set its permission mode with a BLIND, fixed-count Shift+Tab cycler (`sendModeCycles`) that never verified any press against the actual footer. A single dropped or mistimed press under load would half-land the cycle and strand the session at an intermediate mode. Card `b99d3d67`'s own incident report (its "Evidence"/"Trigger correlation" section) observed this live: two freshly-spawned workers were spawned concurrently in one message while a heavy `pnpm build` ran in the background, causing CPU/IO starvation during the press window, and both booted stuck in `plan` mode. That card's "Root cause" section states workers spawn with `ExitPlanMode`/`EnterPlanMode` disallowed, so a worker stuck in plan cannot self-exit — only a human Shift+Tab recovers it. The RESUME path had already been hardened against this exact failure shape by card `f05e4897`'s own footer-verified climb.

The fix routes the fresh-spawn path through that SAME primitive instead of maintaining a second, blind mechanism: read the footer mode, and while it isn't the target, press ONE Shift+Tab and WAIT for the footer to actually CHANGE before deciding again — so a laggy repaint can never trick the cycle into over-pressing past the target.

## Do not

- Do not reintroduce a blind, fixed-count Shift+Tab cycle for the fresh-spawn path — a dropped/mistimed press under load can strand the session at an intermediate mode (incl. `plan`, which a worker cannot self-exit).
- Do not maintain the fresh-spawn and resume mode-convergence paths as two separate mechanisms — they share the same starting point (`acceptEdits`) and the same failure mode, which is why they were unified.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`cycleToMode`'s own method doc), as of main `03e54be9`, for the generalization decision and the design (footer-driven absolute convergence replacing a blind count). The incident detail — the CPU/IO-starvation trigger, the two stuck workers, and the `ExitPlanMode`/`EnterPlanMode` self-exit block — is drawn from card `b99d3d67`'s own body (its "Evidence"/"Trigger correlation" and "Root cause" sections), not from the inline comment, which does not contain it. Condensed and reworded, not verbatim.
