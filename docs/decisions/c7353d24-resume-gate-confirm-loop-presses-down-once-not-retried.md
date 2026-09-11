# c7353d24 — resume-gate confirm loop presses Down once; a retry-based first draft could overshoot onto "Don't ask me again"

## Narrative

Code-review catch on the first draft of `resolveResumeGate`'s Down-confirmation fix (same incident as `sha:29b22e7e`): that draft RETRIED the Down press — re-pressing once the current press's poll window elapsed unconfirmed — which reintroduced the exact class of bug the fix was meant to kill. If Down #1 was merely SLOW to render (not dropped), a retried Down #2 could land right after it, overshooting the cursor 1→2→3 and selecting "Don't ask me again" — worse than the original bug, since that outcome persists the gate-disable AND still compacts this turn.

The shipped design presses Down exactly ONCE and never again on the normal path. Instead of retrying, the poll budget (`RESUME_GATE_MAX_POLLS`) is made generous, which makes a two-Down-in-flight race structurally impossible — there is never a second Down for a slow-but-live first press to collide with.

## Do not

- Do not retry the Down press if it hasn't confirmed within its poll window — widen the poll budget instead. A retried Down can land right behind a merely-slow (not dropped) first press and overshoot the cursor onto "Don't ask me again", a worse outcome than the bug the fix exists to kill (it persists the gate-disable AND still compacts the turn).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`resolveResumeGate`'s own method doc), as of this tranche's HEAD. Same introducing commit as `sha:29b22e7e` (`29b22e7e25de03c2c2dc51b4069160eb5453c112`, 2026-07-10) — keyed by card id here rather than the sha because the `RESUME_GATE_POLL_MS`/`RESUME_GATE_MAX_POLLS` constant doc (same file, ~line 719) names this specific catch as "a code-review catch, card c7353d24 follow-up", giving this decision a card id distinct from the sha-keyed record the rest of the function's doc is anchored under. Condensed and reworded, not verbatim.
