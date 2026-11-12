# f951417c — the boot mode-cycle waits (bounded) on `modalWriteBlocked` before pressing Shift+Tab

A just-dismissed boot-dialog candidate refuses writes for its settle window (`MODAL_DISMISS_SETTLE_MS`, 1500ms) without engaging the hold (`20ff76de`, `5450ad93`). The startup cycle fires ~700ms after SessionStart, so for a `default` target (the only target that climbs off the acceptEdits boot) its Shift+Tab was DROPPED at the chokepoint and the cycle ended `footer-unchanged`, leaving the session in acceptEdits, which is more permissive than `default`.

`runCycleToMode`'s `decide` now polls `modalWriteBlocked` (every `RESUME_MODE_READ_POLL_MS`) before each press, until a deadline of cycle start + min(cycle settle + `MODAL_DISMISS_SETTLE_MS` + 2s, `MODE_CYCLE_FALLBACK_MS`); an already-ENGAGED hold short-circuits straight to expiry (it never clears on its own). On expiry it logs a loud `MODE MISMATCH` error, calls `modalBlockedEngaging` (so a candidate that never settles engages the hold exactly as the refused press used to: PROMPT HELD row + owner escalation; a settling candidate is exempted by `engageMidSessionModalHold` itself, so no 5450ad93 deadlock), files ONE durable owner-visible `claude_boot_dialog_stuck` event (`parentNudged:false`, `detail.modeMismatch {target, landed}`; once per Live) and finishes `modal-blocked`. The existing post-ready mismatch notice and HEALABLE_MODES auto-heal then apply.

Known residual: if expiry happens on a SETTLING candidate (only possible with a `LOOM_MODAL_DISMISS_SETTLE_MS` larger than the fallback headroom) no hold engages, so nothing later pairs/resolves that mismatch event.

## Do not

- Do not exempt `shift-tab` from `ptyWrite`'s chokepoint or add a second write path around it (`20ff76de`).
- Do not press while blocked and rely on the footer read to notice the drop; wait first.
- Do not make the wait unbounded or longer than fits in `MODE_CYCLE_FALLBACK_MS`; an engaged hold never clears on its own.
- Do not swallow the expiry silently.
